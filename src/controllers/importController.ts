import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { parseCsv } from '../services/csvAdapter';
import { importListings } from '../services/importService';

const MAX_ROWS = 200;

export class ImportController {
  static async importCsv(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const sellerId = req.user!.id;
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: 'CSV file is required' });
        return;
      }

      const { rows, failed, warnings } = parseCsv(file.buffer);
      const totalParsedRows = rows.length + failed.length;

      if (totalParsedRows > MAX_ROWS) {
        res.status(400).json({
          error: `CSV exceeds the ${MAX_ROWS}-row limit (found ${totalParsedRows} rows)`,
        });
        return;
      }

      const result = await importListings(rows, sellerId, failed, warnings);

      res.status(200).json(result);
    } catch (error: any) {
      console.error('Import CSV error:', error);
      res.status(500).json({ error: 'Failed to import CSV' });
    }
  }
}
