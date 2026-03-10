import { Router, Request, Response } from 'express';
import { listObjectives, createObjective, deleteObjective } from '../services/testObjectiveService';
import type { TestObjective } from '../types/testObjective';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json(listObjectives());
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
