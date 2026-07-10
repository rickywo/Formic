import { Router, Request, Response } from 'express';
import { listObjectives, createObjective, deleteObjective, getObjective } from '../services/testObjectiveService';
import type { TestObjective } from '../types/testObjective';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json(listObjectives());
});

router.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const objective = getObjective(id);
  if (!objective) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.status(200).json(objective);
});

router.post('/', (req: Request, res: Response) => {
  const input = req.body as Omit<TestObjective, 'id'>;
  res.status(201).json(createObjective(input));
});

router.delete('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  res.status(200).json(deleteObjective(id));
});

export default router;
