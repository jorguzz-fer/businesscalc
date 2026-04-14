import { describe, it, expect } from 'vitest';
import {
  SignupSchema,
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
} from '../src/schemas/auth.schema.js';

describe('SignupSchema', () => {
  const valid = {
    email: 'user@example.com',
    password: 'correcthorsebatterystaple',
    name: 'Jorge Guzman',
    termsAccepted: true as const,
  };

  it('accepts valid signup', () => {
    expect(SignupSchema.safeParse(valid).success).toBe(true);
  });

  it('lowercases and trims email', () => {
    const parsed = SignupSchema.parse({ ...valid, email: '  USER@Example.COM  ' });
    expect(parsed.email).toBe('user@example.com');
  });

  it('rejects password shorter than 12 chars', () => {
    const r = SignupSchema.safeParse({ ...valid, password: 'short123' });
    expect(r.success).toBe(false);
  });

  it('rejects invalid email', () => {
    expect(SignupSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects termsAccepted=false', () => {
    const r = SignupSchema.safeParse({ ...valid, termsAccepted: false });
    expect(r.success).toBe(false);
  });

  it('strips/rejects extra fields (mass-assignment guard)', () => {
    // With .strict(), extra keys cause the parse to FAIL.
    const r = SignupSchema.safeParse({
      ...valid,
      emailVerified: true,
      isAdmin: true,
    });
    expect(r.success).toBe(false);
  });

  it('name is optional but rejects special characters', () => {
    const noName = SignupSchema.safeParse({ ...valid, name: undefined });
    expect(noName.success).toBe(true);

    const badName = SignupSchema.safeParse({ ...valid, name: '<script>' });
    expect(badName.success).toBe(false);
  });
});

describe('LoginSchema', () => {
  it('accepts valid creds', () => {
    const r = LoginSchema.safeParse({ email: 'a@b.com', password: 'anything1' });
    expect(r.success).toBe(true);
  });

  it('rejects missing password', () => {
    // @ts-expect-error intentional
    expect(LoginSchema.safeParse({ email: 'a@b.com' }).success).toBe(false);
  });

  it('accepts short passwords at login (no revalidation)', () => {
    // Login must accept any non-empty password — re-enforcing min-12 here
    // would lock out users who signed up before the rule was strengthened.
    expect(LoginSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });
});

describe('ForgotPasswordSchema', () => {
  it('accepts email', () => {
    expect(ForgotPasswordSchema.safeParse({ email: 'u@x.com' }).success).toBe(true);
  });

  it('rejects extra fields', () => {
    const r = ForgotPasswordSchema.safeParse({ email: 'u@x.com', spoofed: 1 });
    expect(r.success).toBe(false);
  });
});

describe('ResetPasswordSchema', () => {
  const okToken = 'aAbBcCdDeEfFgGhHiIjJkK'; // 22 base64url chars = 16 bytes

  it('accepts well-formed token + strong password', () => {
    const r = ResetPasswordSchema.safeParse({
      token: okToken,
      newPassword: 'supersecure12345',
    });
    expect(r.success).toBe(true);
  });

  it('rejects short token', () => {
    const r = ResetPasswordSchema.safeParse({
      token: 'tooShort',
      newPassword: 'supersecure12345',
    });
    expect(r.success).toBe(false);
  });

  it('rejects weak new password', () => {
    const r = ResetPasswordSchema.safeParse({
      token: okToken,
      newPassword: 'short',
    });
    expect(r.success).toBe(false);
  });
});

describe('VerifyEmailSchema', () => {
  it('accepts well-formed token', () => {
    expect(VerifyEmailSchema.safeParse({ token: 'a'.repeat(22) }).success).toBe(true);
  });

  it('rejects tokens with invalid characters', () => {
    expect(VerifyEmailSchema.safeParse({ token: '../../etc/passwd' }).success).toBe(false);
  });
});
