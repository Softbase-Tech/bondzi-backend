import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PROVIDERS,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * Resolves a provider by its `name`. A plan row's `provider` column is the
 * key used here. If an admin points a plan at an unregistered provider,
 * checkout fails with a clear error — we never silently fall through.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byName: Map<string, PaymentProvider>;

  constructor(@Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  get(name: string): PaymentProvider {
    const p = this.byName.get(name);
    if (!p) {
      throw new BadRequestException(
        `Unknown payment provider: ${name}. Registered: ${this.names().join(', ')}`,
      );
    }
    return p;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}
