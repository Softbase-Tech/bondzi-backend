import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  s3Bucket: process.env.AWS_S3_BUCKET ?? '',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  region: process.env.AWS_REGION ?? 'af-south-1',
  publicBaseUrl: process.env.AWS_S3_PUBLIC_BASE_URL ?? '',
}));
