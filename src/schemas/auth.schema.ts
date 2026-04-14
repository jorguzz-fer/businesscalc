/**
 * Request body schemas for /api/auth/* endpoints.
 *
 * All schemas use `.strict()` to reject extra fields — this blocks mass
 * assignment where a client tries to set `emailVerified: true` or similar
 * privileged fields.
 *
 * Password rules follow vibesec guidance:
 *   - Minimum 12 chars (stronger than the old 8-char convention)
 *   - No maximum (argon2 will hash anything)
 *   - No composition rules (no forced uppercase/digit/symbol) — research
 *     shows this encourages predictable patterns.
 *
 * Email uses zod's built-in email validator. We lowercase + trim via
 * transform so case/whitespace never causes duplicate accounts.
 */
import { z } from 'zod';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Email inválido')
  .max(254); // RFC 5321 limit

const password = z.string().min(12, 'Senha deve ter ao menos 12 caracteres').max(1024);

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{M}\s'-]+$/u, 'Nome contém caracteres inválidos');

const token = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'Token inválido')
  .min(22) // 16 bytes base64url = 22 chars
  .max(86); // generous upper bound for 64 bytes

export const SignupSchema = z
  .object({
    email,
    password,
    name: name.optional(),
    termsAccepted: z.literal(true, {
      errorMap: () => ({ message: 'É necessário aceitar os termos de uso' }),
    }),
  })
  .strict();
export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z
  .object({
    email,
    password: z.string().min(1).max(1024), // min(1) — login doesn't revalidate strength
  })
  .strict();
export type LoginInput = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z
  .object({
    email,
  })
  .strict();
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z
  .object({
    token,
    newPassword: password,
  })
  .strict();
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const VerifyEmailSchema = z
  .object({
    token,
  })
  .strict();
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;
