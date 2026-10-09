/**
 * Errors that carry a message the cashier can act on.
 *
 * Deliberately in its own module with no imports: services throw these, and a
 * service must not have to pull in the IPC layer — and through it Electron and
 * the database — just to report "only 3 in stock".
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
