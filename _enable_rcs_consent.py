"""Flip ~35% of consented customers to also be rcs_opted_in=true so RCS
   routing actually wins for some customers in demos."""
import sys, random
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from app.db.session import SessionLocal
from app.models import Consent

random.seed(42)
db = SessionLocal()
rows = db.query(Consent).filter(Consent.dnd_status == False).all()
flipped = 0
for c in rows:
    if random.random() < 0.35:
        c.rcs_opted_in = True
        flipped += 1
db.commit()
db.close()
print(f"flipped {flipped} of {len(rows)} consents to rcs_opted_in=true")
