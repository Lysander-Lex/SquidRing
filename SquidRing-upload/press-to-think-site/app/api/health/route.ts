import { json } from '../_shared';
export async function GET() { return json({ ok: true, version: '1.0.0' }); }
