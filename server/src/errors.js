// An error that carries the HTTP status the API should answer with.
// Store functions throw these; the app's error handler turns them into
// { error: message } responses.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (message) => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);
