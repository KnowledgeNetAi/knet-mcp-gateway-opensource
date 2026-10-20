/** A JSON-RPC 2.0 request id: string, number, explicit null, or absent (undefined). */
export type JsonRpcId = string | number | null | undefined;

/** Build a JSON-RPC 2.0 success response. `undefined` ids (absent on the request) are
 *  normalized to `null`, matching how a JSON-RPC id round-trips over JSON (there is no
 *  `undefined` in JSON). */
export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/** Build a JSON-RPC 2.0 error response. Same id normalization as `rpcResult`. */
export function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32000;
export const NOT_FOUND = -32004;
export const UNAUTHENTICATED = -32001;
