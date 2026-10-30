import { runPipeline, generateVariations } from './core/pipeline';
import { PixelBuffer, PipelineOptions, PipelineResult, CandidateVariation } from './core/types';

export interface WorkerInputMessage {
  id?: string | number;
  source: PixelBuffer;
  options: PipelineOptions;
  computeVariations?: boolean;
}

export interface WorkerProgressMessage {
  id?: string | number;
  type: 'progress';
  stage: string;
  progress: number;
}

export interface WorkerDoneMessage {
  id?: string | number;
  type: 'done';
  result: PipelineResult;
  variations?: CandidateVariation[];
}

export interface WorkerErrorMessage {
  id?: string | number;
  type: 'error';
  error: string;
  result?: null;
}

export type WorkerOutputMessage =
  | WorkerProgressMessage
  | WorkerDoneMessage
  | WorkerErrorMessage;

self.addEventListener('message', (event: MessageEvent<WorkerInputMessage>) => {
  const { id, source, options, computeVariations } = event.data || {};

  if (!source || !options) {
    const errorMsg: WorkerErrorMessage = {
      id,
      type: 'error',
      error: 'Missing required parameters: source and options are required.'
    };
    self.postMessage(errorMsg);
    return;
  }

  try {
    const result = runPipeline(source, options, (stage, progress) => {
      const progressMsg: WorkerProgressMessage = {
        id,
        type: 'progress',
        stage,
        progress: computeVariations ? progress * 0.7 : progress
      };
      self.postMessage(progressMsg);
    });

    let variations: CandidateVariation[] | undefined;
    if (computeVariations) {
      variations = generateVariations(source, options, 10);
    }

    const doneMsg: WorkerDoneMessage = {
      id,
      type: 'done',
      result,
      variations
    };
    self.postMessage(doneMsg);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const errorMsg: WorkerErrorMessage = {
      id,
      type: 'error',
      error: message
    };
    self.postMessage(errorMsg);
  }
});
