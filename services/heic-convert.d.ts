declare module "heic-convert" {
  interface ConvertOptions { buffer: Buffer | ArrayBuffer; format: "JPEG" | "PNG"; quality?: number }
  export default function convert(options: ConvertOptions): Promise<ArrayBuffer>;
}
