import { ApiError } from "./errors.ts";
import type { JsonRecord } from "./types.ts";

export async function readJson(req: Request): Promise<JsonRecord> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  try {
    const value: unknown = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JsonRecord;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }
}

export function stringField(
  input: JsonRecord,
  key: string,
  options: { required?: boolean; min?: number; max?: number; trim?: boolean } = {},
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (options.required) throw new ApiError(400, "VALIDATION_ERROR", `${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a string.`);
  }
  const result = options.trim === false ? value : value.trim();
  if (result.length < (options.min ?? 0) || result.length > (options.max ?? Infinity)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} has an invalid length.`);
  }
  return result;
}

export function integerField(
  input: JsonRecord,
  key: string,
  options: { required?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (options.required) throw new ApiError(400, "VALIDATION_ERROR", `${key} is required.`);
    return undefined;
  }
  if (
    !Number.isInteger(value) || (value as number) < (options.min ?? -Infinity) ||
    (value as number) > (options.max ?? Infinity)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid integer.`);
  }
  return value as number;
}

export function uuidField(input: JsonRecord, key: string, required = true): string | undefined {
  const value = stringField(input, key, { required, min: 36, max: 36 });
  if (
    value &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a UUID.`);
  }
  return value;
}

export function enumField<T extends string>(
  input: JsonRecord,
  key: string,
  allowed: readonly T[],
  required = false,
): T | undefined {
  const value = stringField(input, key, { required });
  if (value && !allowed.includes(value as T)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T | undefined;
}
