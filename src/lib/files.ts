import { Directory, File, Paths } from "expo-file-system";

export async function persistCapture(sourceUri: string, fileName: string): Promise<string> {
  const directory = new Directory(Paths.cache, "go2");
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  const source = new File(sourceUri);
  const destination = new File(directory, fileName);
  if (destination.exists) destination.delete();
  await source.copy(destination);
  return destination.uri;
}

export function deleteCachedFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The cache file is already gone.
  }
}
