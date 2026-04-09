export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) return res.status(response.status).json({ error: `Pinterest returned ${response.status}` });

    const html = await response.text();

    // Extract all Pinterest CDN image URLs from the page HTML/JSON
    const raw = html.match(/https:\/\/i\.pinimg\.com\/[0-9]+x\/[^"'\s\\>]+\.(?:jpg|jpeg|png|webp)/g) || [];
    const seen = new Set();
    const images = [];
    for (const u of raw) {
      // Normalise to 564x for good quality thumbnails
      const norm = u.replace(/\/[0-9]+x\//, '/564x/');
      if (!seen.has(norm)) { seen.add(norm); images.push(norm); }
      if (images.length >= 30) break;
    }

    res.status(200).json({ images });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
