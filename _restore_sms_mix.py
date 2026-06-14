"""Flip ~25% of customers off WhatsApp consent so routing falls through to SMS,
   then reset all campaigns to draft + wipe their comms so a fresh launch
   shows whatsapp + sms + email in the mix."""
import sys, random
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from sqlalchemy import delete
from app.db.session import SessionLocal
from app.models import Campaign, Communication, CommunicationEvent, Consent

random.seed(31)
db = SessionLocal()

candidates = db.query(Consent).filter(Consent.dnd_status == False, Consent.whatsapp_opted_in == True).all()
flipped = 0
for c in candidates:
    if random.random() < 0.25:
        c.whatsapp_opted_in = False
        flipped += 1
print(f"flipped {flipped} of {len(candidates)} customers off WhatsApp (still SMS/email opted-in)")

for c in db.query(Campaign).all():
    comm_ids = [r[0] for r in db.query(Communication.id).filter(Communication.campaign_id == c.id).all()]
    if comm_ids:
        db.execute(delete(CommunicationEvent).where(CommunicationEvent.communication_id.in_(comm_ids)))
        db.execute(delete(Communication).where(Communication.id.in_(comm_ids)))
    c.status = "draft"
    c.launched_at = None
    c.completed_at = None
print(f"reset {db.query(Campaign).count()} campaigns to draft")

db.commit()
db.close()
print("Done. Relaunch via HTTP next.")
