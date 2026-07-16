import type { DrumTrainerAPI } from "./index.js";

declare global {
  interface Window {
    drumTrainer: DrumTrainerAPI;
  }
}

export {};
