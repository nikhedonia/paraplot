export interface RenderSettings {
  scale: number;
  maxSteps: number;
  shadows: boolean;
  ao: boolean;
  grid: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  scale: 0.8,
  maxSteps: 128,
  shadows: true,
  ao: true,
  grid: true,
};
