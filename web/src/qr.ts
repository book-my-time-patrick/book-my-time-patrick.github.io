import QRCode from 'qrcode';

const svgNamespace = 'http://www.w3.org/2000/svg';

export async function setupQrSvg(uri: string): Promise<string> {
  if (uri.length > 2048) throw new Error('Invalid authenticator URI');
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp' || !url.pathname || url.username || url.password || url.port || url.hash || !/^[A-Z2-7]{16,128}$/.test(url.searchParams.get('secret') ?? '')) {
    throw new Error('Invalid authenticator URI');
  }
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, color: { dark: '#000000', light: '#ffffff' } });
}

export async function createSetupQr(uri: string): Promise<SVGSVGElement> {
  const markup = await setupQrSvg(uri);
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const source = parsed.documentElement;
  const viewBox = source.getAttribute('viewBox') ?? '';
  if (source.localName !== 'svg' || source.namespaceURI !== svgNamespace || !/^0 0 \d+ \d+$/.test(viewBox) || parsed.querySelector('parsererror')) {
    throw new Error('Invalid QR output');
  }
  // Rebuild only QR paths. No URI text, scripts, styles, links or external resources enter the DOM.
  const result = document.createElementNS(svgNamespace, 'svg');
  result.setAttribute('viewBox', viewBox);
  result.setAttribute('shape-rendering', 'crispEdges');
  result.setAttribute('role', 'img');
  result.setAttribute('aria-label', '身份验证器绑定二维码');
  for (const child of source.children) {
    if (child.localName !== 'path' || child.namespaceURI !== svgNamespace) throw new Error('Invalid QR output');
    const path = document.createElementNS(svgNamespace, 'path');
    const data = child.getAttribute('d') ?? '';
    if (!data || !/^[MmLlHhVvZz\d., \-]+$/.test(data)) throw new Error('Invalid QR output');
    path.setAttribute('d', data);
    for (const attribute of ['fill', 'stroke']) {
      const value = child.getAttribute(attribute);
      if (value !== null) {
        if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Invalid QR output');
        path.setAttribute(attribute, value);
      }
    }
    result.append(path);
  }
  if (!result.children.length) throw new Error('Invalid QR output');
  return result;
}
