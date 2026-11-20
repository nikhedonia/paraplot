export type ViewMode = 'shaded' | 'normals' | 'curvature' | 'gradient' | 'zebra';

export interface RenderSettings {
  scale: number;
  maxSteps: number;
  shadows: boolean;
  ao: boolean;
  grid: boolean;
  /** surface analysis view (shaded = off) */
  view: ViewMode;
  /** mean-curvature value mapped to full colour (1/length) */
  curvatureScale: number;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  scale: 0.8,
  maxSteps: 128,
  shadows: true,
  ao: true,
  grid: true,
  view: 'shaded',
  curvatureScale: 4,
};
