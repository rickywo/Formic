import express from 'express';
import testObjectivesRouter from './routes/testObjectives';

const app = express();
const PORT = 3000;

app.use(express.json());

app.use('/api/test-objectives', testObjectivesRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
