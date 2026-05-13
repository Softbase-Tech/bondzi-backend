import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

/**
 * Normalise the FIREBASE_PRIVATE_KEY value that arrives from process.env.
 *
 * Three common breakages we recover from:
 *   1. The whole PEM wrapped in double or single quotes
 *      (dotenv usually strips these but some deploy tools don't).
 *   2. "\n" escape sequences that never got converted to real newlines —
 *      happens when the value was wrapped in single quotes in the .env.
 *   3. Whitespace padding.
 */
function normalisePrivateKey(raw: string): string {
  let key = raw.trim();
  // Strip symmetrical surrounding quotes.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  // If the key still has literal "\n" two-char sequences (because it was
  // single-quoted in the .env and dotenv didn't interpret the escape), turn
  // them into real newlines. Safe to do even when newlines are already real.
  if (key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n');
  }
  return key;
}

/**
 * Thin wrapper around firebase-admin. Initialises once at module boot using
 * the Firebase service-account credentials injected via env. If no credentials
 * are configured (local dev without Firebase), or if parsing fails, sends
 * become a no-op and the API keeps serving — push is never a hard dependency.
 */
@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = normalisePrivateKey(
      this.config.get<string>('firebase.privateKey') ?? '',
    );

    if (!projectId || !privateKey || !clientEmail) {
      this.logger.warn(
        'Firebase not configured (missing FIREBASE_* env). Push sends will no-op.',
      );
      return;
    }

    if (!privateKey.includes('-----BEGIN')) {
      // Common misconfig: key was pasted without its PEM header, or the .env
      // parser stripped the newlines and we couldn't recover them. Log and
      // skip — don't take the whole API down because push is broken.
      this.logger.error(
        'FIREBASE_PRIVATE_KEY is set but does not look like a PEM block ' +
          '(missing "-----BEGIN ... PRIVATE KEY-----" header). ' +
          'Check that newlines are preserved as literal \\n in your .env. ' +
          'Push sends will no-op until this is fixed.',
      );
      return;
    }

    try {
      this.app =
        admin.apps.find((a) => a?.name === 'passmaster') ??
        admin.initializeApp(
          {
            credential: admin.credential.cert({
              projectId,
              clientEmail,
              privateKey,
            }),
          },
          'passmaster',
        );
      this.logger.log('Firebase Admin initialised');
    } catch (err) {
      // Bad credentials should degrade, not crash. The rest of the API —
      // auth, exams, payments — has nothing to do with FCM.
      this.app = null;
      this.logger.error(
        `Firebase Admin init failed: ${(err as Error).message}. Push sends will no-op.`,
      );
    }
  }

  get configured(): boolean {
    return this.app !== null;
  }

  /**
   * Send to multiple tokens and return the tokens that FCM reports as
   * invalid (UNREGISTERED / INVALID_ARGUMENT) so the caller can prune them.
   */
  async sendToTokens(
    tokens: string[],
    message: { title: string; body: string; data?: Record<string, string> },
  ): Promise<{ successCount: number; invalidTokens: string[] }> {
    if (!this.app || tokens.length === 0) {
      return { successCount: 0, invalidTokens: [] };
    }
    const resp = await this.app.messaging().sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data ?? {},
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    const invalidTokens: string[] = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code ?? '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-argument' ||
          code === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(tokens[i]);
        } else {
          this.logger.warn(
            `FCM send failed for token ${tokens[i].slice(0, 12)}…: ${code}`,
          );
        }
      }
    });
    return { successCount: resp.successCount, invalidTokens };
  }
}
