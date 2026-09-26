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

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Tintenpunkte: Pixel, die deutlich dunkler sind als ihre Umgebung (lokaler Mittelwert) und als das Papier.
 * Der Vergleich mit der Umgebung statt mit einem festen Grauwert ist nötig, weil farbiges Papier (blaue Kassenbons)
 * sonst als Tinte zählt und das Profil von der Blattkante statt von den Zeilen bestimmt wird.
 */
function inkPoints(img: Gray, maxPoints: number): { x: number[]; y: number[] } {
  const { data, width, height, stride } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / (maxPoints * 4))));
  const gw = Math.ceil(width / step);
  const gh = Math.ceil(height / step);
  const g = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const p = (j * step * width + i * step) * stride;
      g[j * gw + i] = stride >= 3 ? 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] : data[p];
    }
  }
  if (g.length === 0) return { x: [], y: [] };
  const paper = [...g].sort((a, b) => a - b)[Math.floor(g.length * 0.9)];

  // Summenbild für schnelle Mittelwerte über ein Fenster von etwa 1/30 der langen Seite
  const integral = new Float64Array((gw + 1) * (gh + 1));
  for (let j = 0; j < gh; j++) {
    let row = 0;
    for (let i = 0; i < gw; i++) {
      row += g[j * gw + i];
      integral[(j + 1) * (gw + 1) + i + 1] = integral[j * (gw + 1) + i + 1] + row;
    }
  }
  const r = Math.max(2, Math.round(Math.max(width, height) / step / 60));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const [i0, i1, j0, j1] = [Math.max(0, i - r), Math.min(gw, i + r + 1), Math.max(0, j - r), Math.min(gh, j + r + 1)];
      const sum = integral[j1 * (gw + 1) + i1] - integral[j0 * (gw + 1) + i1] - integral[j1 * (gw + 1) + i0] + integral[j0 * (gw + 1) + i0];
      const mean = sum / ((i1 - i0) * (j1 - j0));
      const v = g[j * gw + i];
      if (v < 0.72 * mean && v < 0.85 * paper) {
        xs.push(i * step);
        ys.push(j * step);
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

/** Bereich, in dem 99 % der Tintenpunkte liegen (einzelne Staubkörner am Rand zählen nicht). */
function robustBounds(xs: number[], ys: number[]): Bounds {
  const pick = (v: number[], q: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.max(0, Math.floor(v.length * q)))];
  return { x0: pick(xs, 0.005), x1: pick(xs, 0.995), y0: pick(ys, 0.005), y1: pick(ys, 0.995) };
}

export interface Skew {
  /** Drehung der Zeilen in Grad (positiv = Zeilen fallen nach rechts unten ab, y nach unten); 0 = keine/unsicher */
  degrees: number;
  /** Bereich der Tinte in Bildkoordinaten NACH dem Begradigen um die Bildmitte (nur wenn Text gefunden wurde) */
  bounds?: Bounds;
}

/**
 * Schätzt die Drehung der Zeilen. Ergebnis 0, wenn die Seite kaum Text hat oder die Verbesserung gegenüber
 * „gerade“ zu klein ist. Zum Begradigen das Bild um -degrees drehen.
 */
export function measureSkew(img: Gray, maxDegrees = 30): Skew {
  if (!(maxDegrees > 0)) return { degrees: 0 };
  const { x, y } = inkPoints(img, 60_000);
  if (x.length < 500) return { degrees: 0 };
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
  const degrees = Math.abs(best) < 0.3 || bestScore < straight * 1.03 ? 0 : Math.round(best * 10) / 10;
  // Tintenbereich nach dem Drehen um -degrees (Bildmitte als Drehpunkt), um zu prüfen, ob er noch auf die Seite passt
  const rad = (degrees * Math.PI) / 180;
  const [cx, cy] = [img.width / 2, img.height / 2];
  const rx = x.map((px, i) => cx + (px - cx) * Math.cos(rad) + (y[i] - cy) * Math.sin(rad));
  const ry = x.map((px, i) => cy - (px - cx) * Math.sin(rad) + (y[i] - cy) * Math.cos(rad));
  return { degrees, bounds: robustBounds(rx, ry) };
}

/** Wie measureSkew, liefert nur den Winkel in Grad. */
export function detectSkew(img: Gray, maxDegrees = 30): number {
  return measureSkew(img, maxDegrees).degrees;
}
