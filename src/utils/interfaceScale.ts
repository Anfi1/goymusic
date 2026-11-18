export const interfaceScales = [100, 110, 125, 150] as const;
export type InterfaceScale = typeof interfaceScales[number];

export function isInterfaceScale(value: number): value is InterfaceScale {
    return interfaceScales.some(scale => scale === value);
}

const key = 'goymusic-interface-scale';

export function readInterfaceScale(): InterfaceScale {
    const saved = Number(localStorage.getItem(key));
    return isInterfaceScale(saved) ? saved : 100;
}

export function setInterfaceScale(scale: InterfaceScale) {
    window.bridge.setInterfaceScale(scale);
    localStorage.setItem(key, String(scale));
}
