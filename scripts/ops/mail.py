import json, os, smtplib, ssl, sys
from email.message import EmailMessage
try:
    payload=json.load(sys.stdin)
    required=['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','SMTP_FROM']
    if not all(os.environ.get(k) for k in required):
        print('EMAIL_NOT_CONFIGURED');sys.exit(2)
    msg=EmailMessage()
    msg['From']=os.environ['SMTP_FROM']
    msg['To']='thanapong.tong-u-thai@iamconsulting.co.th'
    msg['Subject']=payload['subject'];msg.set_content(payload['body'])
    with smtplib.SMTP(os.environ['SMTP_HOST'],int(os.environ.get('SMTP_PORT','587')),timeout=30) as smtp:
        smtp.ehlo();smtp.starttls(context=ssl.create_default_context());smtp.ehlo()
        smtp.login(os.environ['SMTP_USERNAME'],os.environ['SMTP_PASSWORD'])
        smtp.send_message(msg)
    print('EMAIL_ACCEPTED')
except Exception:
    print('EMAIL_DELIVERY_FAILED');sys.exit(1)
