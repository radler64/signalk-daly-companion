#!/usr/bin/env python3
"""daly-cmd.py MAC (charge|discharge) (on|off) | MAC soc PERCENT
Sends one write command to a Daly Smart BMS over BLE (service FFF0, write FFF2, notify FFF1)
and prints the BMS reply as JSON. Used by signalk-daly-companion; the Daly reader plugin must be
paused while this runs (the BMS allows a single BLE connection)."""
import asyncio, json, sys, datetime
from bleak import BleakClient

NOTIFY = "0000fff1-0000-1000-8000-00805f9b34fb"
WRITE  = "0000fff2-0000-1000-8000-00805f9b34fb"

def frame(cmd, data):
    b = bytearray([0xA5, 0x80, cmd, 0x08]) + bytearray(data) + bytearray(8 - len(data))
    b.append(sum(b) & 0xFF)
    return bytes(b)

def build(args):
    kind = args[0]
    if kind in ("charge", "discharge"):
        on = args[1].lower() in ("on", "1", "ein", "true")
        return frame(0xD9 if kind == "charge" else 0xDA, [1 if on else 0])
    if kind == "soc":
        pct = float(args[1])
        if not 0 <= pct <= 100: raise SystemExit("soc 0-100")
        n = datetime.datetime.now()
        v = int(round(pct * 10))
        return frame(0x21, [n.year - 2000, n.month, n.day, n.hour, n.minute, n.second, v >> 8, v & 0xFF])
    raise SystemExit("usage: charge|discharge on|off  or  soc PERCENT")

async def main(mac, args):
    req = build(args)
    got = asyncio.get_event_loop().create_future()
    def cb(_, data):
        if len(data) >= 13 and data[0] == 0xA5 and not got.done():
            got.set_result(bytes(data))
    async with BleakClient(mac, timeout=20) as c:
        await c.start_notify(NOTIFY, cb)
        await c.write_gatt_char(WRITE, req, response=False)
        try:
            rep = await asyncio.wait_for(got, 6)
        except asyncio.TimeoutError:
            rep = None
        await c.stop_notify(NOTIFY)
    ok = rep is not None and rep[2] == req[2]
    print(json.dumps({"ok": ok, "sent": req.hex(), "reply": rep.hex() if rep else None}))
    sys.exit(0 if ok else 2)

if __name__ == "__main__":
    if len(sys.argv) < 4: raise SystemExit(__doc__)
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
