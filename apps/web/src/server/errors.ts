/** 利用者に返してよいエラー。code は画面の文言の切り替えに使う。 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const notFound = (code = "not_found") => new AppError(code, 404);
export const conflict = (code: string, detail?: Record<string, unknown>) => new AppError(code, 409, detail);
export const unauthorized = () => new AppError("unauthorized", 401);
export const badRequest = (code: string) => new AppError(code, 400);
