/**
 * Schräglage einer gescannten Seite schätzen (Projektionsprofil): Bei richtigem Winkel fallen die Tintenpunkte der
 * Textzeilen in wenige, dichte Zeilen des Histogramms; der Winkel mit dem schärfsten Profil gewinnt.
 */

export interface Gray {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Anzahl Werte je Pixel in data (RGBA = 4, Graustufen = 1) */
  stride: number;
}

/** Tintenpunkte (dunkler als 60 % der Papierhelligkeit), gleichmäßig auf höchstens maxPoints ausgedünnt. */
function inkPoints(img: Gray, maxPoints: number): { x: number[]; y: number[] } {
  const { data, width, height, stride } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / (maxPoints * 4))));
  const luma = (i: number) => (stride >= 3 ? 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] : data[i]);

  // Papierhelligkeit: 90. Perzentil einer Stichprobe
  const sample: number[] = [];
  for (let y = 0; y < height; y += step * 2) for (let x = 0; x < width; x += step * 2) sample.push(luma((y * width + x) * stride));
  if (sample.length === 0) return { x: [], y: [] };
  sample.sort((a, b) => a - b);
  const threshold = sample[Math.floor(sample.length * 0.9)] * 0.6;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (luma((y * width + x) * stride) < threshold) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return { x: xs, y: ys };
}

/** Schärfe des Zeilenprofils für einen Winkel (Grad); höher = Zeilen liegen waagerechter. */
function profileScore(xs: number[], ys: number[], degrees: number, binSize: number, height: number, width: number): number {
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  // Abstand senkrecht zu Zeilen mit Richtung (cos, sin) in Bildkoordinaten (y nach unten)
  const offset = Math.abs(width * sin);
  const bins = new Uint32Array(Math.ceil((height * Math.abs(cos) + offset) / binSize) + 2);
  for (let i = 0; i < xs.length; i++) {
    const v = -xs[i] * sin + ys[i] * cos + offset;
    bins[Math.floor(v / binSize)]++;
  }
  let score = 0;
  for (const c of bins) score += c * c;
  return score;
}

/**
 * Schätzt die Drehung der Zeilen in Grad (positiv = Zeilen fallen nach rechts unten ab, y nach unten).
 * Ergebnis 0, wenn die Seite kaum Text hat oder die Verbesserung gegenüber „gerade“ zu klein ist.
 * Zum Begradigen das Bild um -Ergebnis drehen.
 */
export function detectSkew(img: Gray, maxDegrees = 10): number {
  if (!(maxDegrees > 0)) return 0;
  const { x, y } = inkPoints(img, 60_000);
  if (x.length < 500) return 0;
  const binSize = Math.max(2, Math.round(Math.min(img.width, img.height) / 400));
  const score = (deg: number) => profileScore(x, y, deg, binSize, img.height, img.width);

  let best = 0;
  let bestScore = score(0);
  const straight = bestScore;
  for (let deg = -maxDegrees; deg <= maxDegrees + 1e-9; deg += 0.5) {
    const s = score(deg);
    if (s > bestScore) [best, bestScore] = [deg, s];
  }
  const coarse = best;
  for (let deg = coarse - 0.5; deg <= coarse + 0.5 + 1e-9; deg += 0.1) {
    const s = score(deg);
    if (s > bestScore) [best, bestScore] = [deg, s];
  }
  // Unsichere Funde (kaum schärferes Profil) und Winzigkeiten nicht anfassen
  if (Math.abs(best) < 0.3 || bestScore < straight * 1.03) return 0;
  return Math.round(best * 10) / 10;
}
