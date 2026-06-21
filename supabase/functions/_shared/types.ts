export type ProjectRole = "owner" | "admin" | "member";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  agent_name: string;
  agent_instructions: string | null;
  default_model: "gpt-5.4-nano" | "gpt-5.4-mini";
  status: "active" | "archived";
  max_context_chars_per_source: number;
  max_chunks_per_project: number;
  max_chat_messages_per_day: number;
  max_file_size_mb: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSource {
  id: string;
  project_id: string;
  created_by: string;
  source_type: "text" | "file" | "url" | "manual";
  title: string | null;
  raw_text: string | null;
  storage_path: string | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  content_hash: string | null;
  embedding_model: string | null;
  status: SourceStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RetrievedChunk {
  chunk_id: string;
  source_id: string;
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export type JsonRecord = Record<string, unknown>;
