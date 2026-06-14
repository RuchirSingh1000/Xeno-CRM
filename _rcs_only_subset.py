"""Make ~18% of customers RCS-only (rcs=true, whatsapp=false) so the routing
actually picks RCS for them. Otherwise WhatsApp wins every priority race."""
import sys, random
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from app.db.session import SessionLocal
from app.models import Consent

random.seed(7)
db = SessionLocal()
candidates = db.query(Consent).filter(Consent.dnd_status == False, Consent.rcs_opted_in == True).all()
flipped = 0
for c in candidates:
    if random.random() < 0.55:
        c.whatsapp_opted_in = False
        flipped += 1
db.commit()
db.close()
print(f"made {flipped} of {len(candidates)} RCS-only (whatsapp=false, rcs=true)")
