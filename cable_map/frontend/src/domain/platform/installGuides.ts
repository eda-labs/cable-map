export interface InstallGuide {
  family: string;
  url: string;
}

const INSTALL_GUIDES: readonly (InstallGuide & { prefix: string })[] = [
  {
    prefix: '7215 IXS',
    family: '7215 IXS',
    url: 'https://documentation.nokia.com/pybin/doc_ctr.py?product_id=833-066294&model=754&model_name=Hardware&category=Installation&sortby=Issue%20Date',
  },
  {
    prefix: '7220 IXR',
    family: '7220 IXR',
    url: 'https://documentation.nokia.com/pybin/doc_ctr.py?product_id=833-064480&model=753&model_name=Hardware&category=Installation&sortby=Issue%20Date',
  },
  {
    prefix: '7250 IXR',
    family: '7250 IXR',
    url: 'https://documentation.nokia.com/pybin/doc_ctr.py?product_id=833-011541&model=660&model_name=Hardware&category=Installation&sortby=Issue%20Date',
  },
  {
    prefix: '7730 SXR',
    family: '7730 SXR',
    url: 'https://documentation.nokia.com/pybin/doc_ctr.py?product_id=833-081666&category=Installation&sortby=Issue%20Date',
  },
  {
    prefix: '7750 SR',
    family: '7750 SR',
    url: 'https://documentation.nokia.com/pybin/doc_ctr.py?product_id=833-006358&model=562&model_name=Hardware&category=Installation&sortby=Issue%20Date',
  },
];

export function installGuideForPlatform(platform: string): InstallGuide | undefined {
  const value = platform.trim().replace(/\s+/g, ' ').toUpperCase();
  return INSTALL_GUIDES.find((guide) => {
    const prefix = guide.prefix.toUpperCase();
    return value === prefix || value.startsWith(`${prefix}-`) || value.startsWith(`${prefix} `);
  });
}
