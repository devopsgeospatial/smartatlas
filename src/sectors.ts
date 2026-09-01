import type { Sector } from './types';

export const SECTOR_LIST: Sector[] = [
  { s: 'Bumbogo', d: 'Gasabo', bb: [30.11017, -1.94885, 30.19877, -1.82331] },
  { s: 'Gatsata', d: 'Gasabo', bb: [30.03379, -1.94187, 30.05044, -1.90318] },
  { s: 'Gikomero', d: 'Gasabo', bb: [30.18944, -1.90215, 30.26426, -1.84333] },
  { s: 'Gisozi', d: 'Gasabo', bb: [30.04966, -1.93375, 30.076, -1.904] },
  { s: 'Jabana', d: 'Gasabo', bb: [30.03006, -1.90315, 30.09689, -1.82597] },
  { s: 'Jali', d: 'Gasabo', bb: [29.98987, -1.93927, 30.05112, -1.83681] },
  { s: 'Kacyiru', d: 'Gasabo', bb: [30.06141, -1.9492, 30.09714, -1.92739] },
  { s: 'Kimihurura', d: 'Gasabo', bb: [30.07441, -1.96445, 30.10218, -1.9446] },
  { s: 'Kimironko', d: 'Gasabo', bb: [30.1049, -1.96069, 30.13917, -1.92193] },
  { s: 'Kinyinya', d: 'Gasabo', bb: [30.06064, -1.93337, 30.12864, -1.88879] },
  { s: 'Ndera', d: 'Gasabo', bb: [30.13804, -1.9786, 30.22785, -1.86985] },
  { s: 'Nduba', d: 'Gasabo', bb: [30.07361, -1.89162, 30.14342, -1.80857] },
  { s: 'Remera', d: 'Gasabo', bb: [30.09349, -1.9687, 30.12608, -1.92419] },
  { s: 'Rusororo', d: 'Gasabo', bb: [30.18367, -1.98764, 30.27613, -1.89444] },
  { s: 'Rutunga', d: 'Gasabo', bb: [30.13075, -1.86717, 30.21786, -1.78046] },
  { s: 'Gahanga', d: 'Kicukiro', bb: [30.07872, -2.05832, 30.14896, -1.9984] },
  { s: 'Gatenga', d: 'Kicukiro', bb: [30.0639, -2.03107, 30.10419, -1.96912] },
  { s: 'Gikondo', d: 'Kicukiro', bb: [30.06939, -1.99411, 30.08734, -1.95492] },
  { s: 'Kagarama', d: 'Kicukiro', bb: [30.09191, -2.012, 30.1341, -1.98392] },
  { s: 'Kanombe', d: 'Kicukiro', bb: [30.11524, -2.03514, 30.16623, -1.95962] },
  { s: 'Kicukiro', d: 'Kicukiro', bb: [30.08662, -1.98186, 30.10503, -1.9643] },
  { s: 'Kigarama', d: 'Kicukiro', bb: [30.04848, -2.00763, 30.07742, -1.96196] },
  { s: 'Masaka', d: 'Kicukiro', bb: [30.16772, -2.07829, 30.23389, -1.98205] },
  { s: 'Niboye', d: 'Kicukiro', bb: [30.10296, -1.99194, 30.12635, -1.95999] },
  { s: 'Nyarugunga', d: 'Kicukiro', bb: [30.12069, -1.99465, 30.18435, -1.9543] },
  { s: 'Gitega', d: 'Nyarugenge', bb: [30.04573, -1.96606, 30.05997, -1.94102] },
  { s: 'Kanyinya', d: 'Nyarugenge', bb: [29.97807, -1.94861, 30.03447, -1.86698] },
  { s: 'Kigali', d: 'Nyarugenge', bb: [29.99764, -2.0192, 30.0403, -1.94221] },
  { s: 'Kimisagara', d: 'Nyarugenge', bb: [30.03813, -1.96328, 30.05578, -1.94] },
  { s: 'Mageregere', d: 'Nyarugenge', bb: [29.98637, -2.07161, 30.08637, -2.00184] },
  { s: 'Muhima', d: 'Nyarugenge', bb: [30.0451, -1.954, 30.07573, -1.9349] },
  { s: 'Nyakabanda', d: 'Nyarugenge', bb: [30.03653, -1.97914, 30.05554, -1.96059] },
  { s: 'Nyamirambo', d: 'Nyarugenge', bb: [30.03175, -2.01563, 30.06149, -1.97093] },
  { s: 'Nyarugenge', d: 'Nyarugenge', bb: [30.05472, -1.97245, 30.07378, -1.94141] },
  { s: 'Rwezamenyo', d: 'Nyarugenge', bb: [30.04669, -1.97816, 30.05876, -1.96034] },
];

export const CITY_BBOX: [number, number, number, number] = [
  29.97807, -2.07829, 30.27613, -1.78046,
];

export const DISTRICTS: Record<string, string> = {};
export const SECTOR_BBOX: Record<string, [number, number, number, number]> = {};
SECTOR_LIST.forEach((s) => {
  DISTRICTS[s.s] = s.d;
  SECTOR_BBOX[s.s] = s.bb;
});
