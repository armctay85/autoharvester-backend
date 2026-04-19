import { Router } from 'express';
import { z } from 'zod';
import { createPendingReport, getReport, runReport } from '../services/reports';

const router = Router();

const requestSchema = z.object({
  vin: z.string().trim().optional(),
  rego: z.string().trim().optional(),
  state: z.string().trim().length(2).or(z.string().trim().length(3)).optional(),
});

router.post('/', async (req, res) => {
  try {
    const parsed = requestSchema.parse(req.body);
    const userId = (req.user as any)?.id ?? null;
    const report = await createPendingReport({
      user_id: userId,
      vin: parsed.vin,
      rego: parsed.rego,
      state: parsed.state,
    });
    // Synchronously run for v1 (PPSR adapters are fast). Async queue can come later.
    const completed = await runReport(report.id);
    res.json({ success: true, report: completed });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err?.message || 'create_failed' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ success: false, error: 'id_required' });
      return;
    }
    const report = await getReport(id);
    if (!report) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'fetch_failed' });
  }
});

export default router;
