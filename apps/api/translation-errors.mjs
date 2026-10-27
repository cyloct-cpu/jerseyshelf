export class TranslationError extends Error {
  constructor(message, code = 'network', retryMs = 60000) {
    super(message); this.code = code; this.retryMs = retryMs;
  }
}
