import { HttpException, HttpStatus } from '@nestjs/common';

export class AiBudgetExceededException extends HttpException {
  constructor(scope: 'global' | 'user' = 'global') {
    super(
      {
        error: 'AiBudgetExceeded',
        scope,
        message: 'AI budget exceeded — serving cached content only for now.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
