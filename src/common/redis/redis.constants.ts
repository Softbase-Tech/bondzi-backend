/** DI token for the shared ioredis client. Lives in its own file so the
 * module and the service can both import it without a circular reference. */
export const REDIS_CLIENT = 'REDIS_CLIENT';
