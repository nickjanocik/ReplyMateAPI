import { createAdminClient, requireProject, requireUser } from "../_shared/auth.ts";
import { ApiError, apiHandler, jsonResponse, requireMethod } from "../_shared/errors.ts";
import {
  createChatResponse,
  createEmbeddings,
  estimateChatCost,
  estimateEmbeddingCost,
  getEmbeddingModel,
} from "../_shared/openai.ts";
import { buildRagInstructions, compactHistory, conversationTitle } from "../_shared/rag.ts";
import type { ConversationMessage, RetrievedChunk } from "../_shared/types.ts";
import { completeAgentRun, recordUsage, startAgentRun } from "../_shared/usage.ts";
import { readJson, stringField, uuidField } from "../_shared/validation.ts";

Deno.serve(apiHandler(async (req) => {
  requireMethod(req, ["GET", "POST"]);
  const { user, supabase } = await requireUser(req);
  const admin = createAdminClient();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const conversationId = url.searchParams.get("conversation_id");
    if (conversationId) {
      const { data: conversation, error } = await supabase.from("conversations").select("*")
        .eq("id", conversationId).maybeSingle();
      if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not load the conversation.");
      if (!conversation) {
        throw new ApiError(
          404,
          "CONVERSATION_NOT_FOUND",
          "Conversation not found or access denied.",
        );
      }
      const { data: messages, error: messageError } = await supabase.from("messages").select("*")
        .eq("conversation_id", conversationId).order("created_at");
      if (messageError) throw new ApiError(500, "DATABASE_ERROR", "Could not load messages.");
      return jsonResponse({ conversation, messages: messages ?? [] });
    }
    const projectId = url.searchParams.get("project_id");
    if (!projectId) throw new ApiError(400, "VALIDATION_ERROR", "project_id is required.");
    await requireProject(supabase, projectId);
    const { data, error } = await supabase.from("conversations").select("*")
      .eq("project_id", projectId).order("updated_at", { ascending: false });
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not list conversations.");
    return jsonResponse({ conversations: data ?? [] });
  }

  const input = await readJson(req);
  const projectId = uuidField(input, "project_id")!;
  const requestedConversationId = uuidField(input, "conversation_id", false);
  const message = stringField(input, "message", { required: true, min: 1, max: 8000 })!;
  const project = await requireProject(supabase, projectId);
  if (project.status !== "active") {
    throw new ApiError(409, "PROJECT_INACTIVE", "This project is not active.");
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await admin.from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId).eq("user_id", user.id).eq("run_type", "chat").gte(
      "created_at",
      since,
    );
  if (countError) throw new ApiError(500, "DATABASE_ERROR", "Could not check the chat limit.");
  if ((count ?? 0) >= project.max_chat_messages_per_day) {
    throw new ApiError(
      429,
      "CHAT_LIMIT_EXCEEDED",
      "The rolling 24-hour chat limit has been reached.",
    );
  }

  let conversationId = requestedConversationId;
  let createdConversation = false;
  if (conversationId) {
    const { data, error } = await supabase.from("conversations").select("id")
      .eq("id", conversationId).eq("project_id", projectId).maybeSingle();
    if (error) throw new ApiError(500, "DATABASE_ERROR", "Could not validate the conversation.");
    if (!data) {
      throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found or access denied.");
    }
  } else {
    const { data, error } = await supabase.from("conversations").insert({
      project_id: projectId,
      user_id: user.id,
      title: conversationTitle(message),
    }).select("id").single();
    if (error) {
      throw new ApiError(
        500,
        "DATABASE_ERROR",
        "Could not create the conversation.",
        error.message,
      );
    }
    conversationId = data.id as string;
    createdConversation = true;
  }

  const { error: userMessageError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    project_id: projectId,
    role: "user",
    content: message,
  });
  if (userMessageError) {
    throw new ApiError(500, "DATABASE_ERROR", "Could not store the user message.");
  }

  const chatRun = await startAgentRun(admin, {
    projectId,
    conversationId,
    userId: user.id,
    runType: "chat",
    model: project.default_model,
  });
  let embeddingRun: string | null = null;

  try {
    embeddingRun = await startAgentRun(admin, {
      projectId,
      conversationId,
      userId: user.id,
      runType: "embedding",
      model: getEmbeddingModel(),
    });
    const queryEmbedding = await createEmbeddings([message]);
    const embeddingCost = estimateEmbeddingCost(queryEmbedding.model, queryEmbedding.inputTokens);
    await completeAgentRun(admin, embeddingRun, {
      status: "success",
      inputTokens: queryEmbedding.inputTokens,
      estimatedCost: embeddingCost,
      model: queryEmbedding.model,
    });
    await recordUsage(admin, {
      projectId,
      userId: user.id,
      runId: embeddingRun,
      eventType: "embedding_tokens",
      quantity: queryEmbedding.inputTokens,
      unit: "tokens",
      estimatedCost: embeddingCost,
      provider: "openai",
      metadata: {
        model: queryEmbedding.model,
        purpose: "rag_query",
        conversation_id: conversationId,
      },
    });

    const { data: matches, error: matchError } = await supabase.rpc("match_project_chunks", {
      query_embedding: queryEmbedding.embeddings[0],
      match_project_id: projectId,
      match_count: 8,
      similarity_threshold: 0.2,
    });
    if (matchError) {
      throw new ApiError(
        500,
        "VECTOR_SEARCH_ERROR",
        "Could not search project context.",
        matchError.message,
      );
    }
    const chunks = (matches ?? []) as RetrievedChunk[];

    const { data: recent, error: historyError } = await supabase.from("messages")
      .select("role,content,created_at").eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"]).order("created_at", { ascending: false }).limit(12);
    if (historyError) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not load recent conversation history.");
    }
    const history = compactHistory(
      [...(recent ?? [])].reverse().map((item) => ({
        role: item.role as "user" | "assistant",
        content: item.content as string,
      })),
    );

    const result = await createChatResponse({
      model: project.default_model,
      instructions: buildRagInstructions({
        agentName: project.agent_name,
        agentInstructions: project.agent_instructions,
        chunks,
      }),
      messages: history as ConversationMessage[],
      maxOutputTokens: 800,
    });
    const chatCost = estimateChatCost(result.model, result.usage);
    const sourceRefs = chunks.map((chunk) => ({
      source_id: chunk.source_id,
      chunk_id: chunk.chunk_id,
      title: chunk.title,
      similarity: Number(chunk.similarity),
    }));

    await completeAgentRun(admin, chatRun, {
      status: "success",
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCost: chatCost,
      model: result.model,
    });
    await recordUsage(admin, {
      projectId,
      userId: user.id,
      runId: chatRun,
      eventType: "chat_tokens",
      quantity: result.usage.inputTokens + result.usage.outputTokens,
      unit: "tokens",
      estimatedCost: chatCost,
      provider: "openai",
      metadata: {
        model: result.model,
        conversation_id: conversationId,
        cached_input_tokens: result.usage.cachedInputTokens,
      },
    });

    const { error: assistantError } = await admin.from("messages").insert({
      conversation_id: conversationId,
      project_id: projectId,
      role: "assistant",
      content: result.content,
      metadata: { sources: sourceRefs, model: result.model },
    });
    if (assistantError) {
      throw new ApiError(500, "DATABASE_ERROR", "Could not store the assistant response.");
    }
    await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq(
      "id",
      conversationId,
    );

    return jsonResponse({
      conversation_id: conversationId,
      message: { role: "assistant", content: result.content },
      sources: sourceRefs,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        estimated_cost: chatCost + embeddingCost,
      },
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await completeAgentRun(admin, chatRun, { status: "failed", errorMessage: messageText });
    if (embeddingRun) {
      const { data } = await admin.from("agent_runs").select("status").eq("id", embeddingRun)
        .maybeSingle();
      if (data?.status === "pending") {
        await completeAgentRun(admin, embeddingRun, {
          status: "failed",
          errorMessage: messageText,
        });
      }
    }
    if (createdConversation) {
      await admin.from("conversations").update({ updated_at: new Date().toISOString() }).eq(
        "id",
        conversationId,
      );
    }
    throw error;
  }
}));
