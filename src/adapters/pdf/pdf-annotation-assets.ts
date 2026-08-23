export function replacePdfAnnotationImageSources(
  root: HTMLElement,
  images: Readonly<Record<string, string>>,
): void {
  const annotationImages: NodeListOf<HTMLImageElement> =
    root.querySelectorAll('img[src^="annotation-"]');
  annotationImages.forEach((image) => {
    const source = image.getAttribute('src') as string;
    const embedded = images[source];
    if (embedded !== undefined) image.src = embedded;
  });
}
