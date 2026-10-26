/**
 * An error with an HTTP status. Throw it from any route or service and
 * `errorHandler` turns it into a JSON response.
 *
 *   throw new HttpError(404, 'Timing not found');
 *
 * `code` is optional: a stable name the web can branch on without reading the
 * message, which is free to change wording or language.
 */
export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
    if (details) this.details = details;
  }
}
