import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '../types/enums';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;

    if (!user?.role) throw new ForbiddenException('Authentication required');

    // superadmin implicitly satisfies admin-level requirements.
    if (user.role === UserRole.SUPERADMIN) return true;
    if (required.includes(UserRole.ADMIN) && user.role === UserRole.ADMIN)
      return true;

    if (!required.includes(user.role)) {
      throw new ForbiddenException('Insufficient privileges');
    }
    return true;
  }
}
