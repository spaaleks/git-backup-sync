

let stopRequested = false;
export function requestStop() {
  stopRequested = true;
}
export function stopping() {
  return stopRequested;
}
export function resetStop() {
  stopRequested = false;
}
