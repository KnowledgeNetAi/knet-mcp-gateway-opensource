export class UpstreamError extends Error {
  constructor(
    public status: number,
    public path: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`${path} -> HTTP ${status}: ${message}`, options);
    this.name = "UpstreamError";
  }
}
