import sys
sys.path.insert(0, r"D:\xeno-crm\backend\crm-api")
from sqlalchemy import func
from app.db.session import SessionLocal
from app.models import Communication
db = SessionLocal()
print("Communications by current_status:")
for st, n in db.query(Communication.current_status, func.count(Communication.id)).group_by(Communication.current_status).all():
    print(f"  {st or '(null)':<20s} {n}")
db.close()
