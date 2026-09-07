import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET as string,
  refreshSecret: process.env.JWT_REFRESH_SECRET as string,
  accessExpiry: process.env.JWT_ACCESS_EXPIRY ?? '15m',
  refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '30d',
  // Admin/superadmin sessions: the admin panel and the ops scripts
  // (syllabus + learning-material pushes) authenticate with the access
  // token alone — no refresh rotation — and a batch run easily outlives
  // 15 minutes. Students keep the short expiry; their mobile clients
  // rotate refresh tokens.
  adminAccessExpiry: process.env.JWT_ADMIN_ACCESS_EXPIRY ?? '12h',
}));
