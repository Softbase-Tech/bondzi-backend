import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common';

@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' || typeof value !== 'object' || value === null)
      return value;
    return this.trimObject(value as Record<string, unknown>);
  }

  private trimObject(obj: Record<string, unknown>): Record<string, unknown> {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        obj[key] = v.trim();
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        this.trimObject(v as Record<string, unknown>);
      }
    }
    return obj;
  }
}
