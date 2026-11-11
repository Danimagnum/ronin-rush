import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HttpMetrics } from './prometheus';

/**
 * Times every HTTP request handled by Nest. The route label is the matched route template
 * (e.g. /api/me/bets), never the raw URL, so label cardinality stays bounded; anything that
 * matched no route is reported as "unmatched".
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: HttpMetrics) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const template = (req.route as { path?: string } | undefined)?.path;
      const route = template ? `${req.baseUrl ?? ''}${template}` : 'unmatched';
      this.metrics.record(req.method, route, res.statusCode, ms);
    });
    next();
  }
}
