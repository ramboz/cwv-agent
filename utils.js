// A crude approximation of the number of tokens in a string
export function estimateTokenSize(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}