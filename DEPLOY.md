# App ko live karna (Deploy guide)

Is guide ke baad aap ke paas aik website hogi, jaise `https://baitul-aqba.onrender.com`:

| Link | Kis ke liye |
|---|---|
| `https://…/donor` | **Donors.** Is link par entry karein aur receipt upload karein. Mobile par "Add to Home screen" karne se app ki tarah icon ban jata hai. |
| `https://…/admin` | **Aap / management.** Donors ki har entry yahan foran nazar aati hai. |

Sab donors aur aap aik hi server istemal karte hain, is liye jo entry donor karta hai woh usi waqt aap ke Management portal mein aa jati hai.

---

## Tareeqa 1 (sab se aasan): Render.com

Is repo mein `render.yaml` aur `Dockerfile` pehle se tayyar hain, is liye Render sab kuch khud set kar deta hai.
Is ke liye aik paid plan chahiye, kyun ke database aur receipt ki tasveeron ke liye permanent disk chahiye.
Web service taqreeban $7 mahana aur 5 GB disk taqreeban $1–2 mahana hai. Sahi qeemat render.com/pricing par dekh lein.

1. **Code GitHub par tayyar hai.** Repo `asadahmed0604-pixel/baitul-aqba` ki default branch `claude/bait-ul-aqba-donations-onqlqn` hai, aur Render yahi branch khud le leta hai. Agar Render branch pooche to yahi chunein.
2. **Render account banayein.** <https://render.com> par "Sign in with GitHub" karein.
3. **Blueprint banayein.** Dashboard mein **New → Blueprint** dabayein, phir repo `baitul-aqba` chunein.
4. Render do cheezein poochega:
   - `ADMIN_EMAIL`: aap ka management login email
   - `ADMIN_PASSWORD`: mazboot password, kam az kam 10 characters

   Phir **Apply** dabayein.
5. **Intezar karein.** 3–5 minute mein status **Live** ho jayega, aur upar aap ka link dikhega (jaise `https://baitul-aqba.onrender.com`).
6. **Management mein login karein.** `https://…/admin` kholein aur upar wala email/password dalein.
7. **Settings → Foundation accounts** mein foundation ke tamam bank accounts / IBAN dalein. Kisi aur account mein bheja gaya paisa khud flag ho jayega.
8. **Orphans ka data dalein:** **Import / Export** kholein → "What are you importing?" mein **Orphans** chunein → apni Excel file (jaise `Printable.xlsx`) chunein → pehle **Check file** dabayein, phir **Import**.
   - Excel file seedha chalti hai, CSV banane ki zaroorat nahi. Columns: `Code, Orphan's Name, Name, Child Phone, SP Code, Sponsor Name, Sponsor Phone, Sponsor Area`.
   - Har sponsor khud donor ban kar apne orphans se link ho jata hai. Aik phone number = aik donor account.
   - Dobara import karna mehfooz hai: kuch double nahi hota, aur haath se dale gaye monthly amounts nahi mit-te.
   - Har sponsor ka login khud ban jata hai: **username = mobile number (03…)**, ya Pakistan se bahar ke number par **pehla naam** (jaise `rizwana`). **Password = bua- + orphan code**, jaise `bua-or001`.
   - **Donors → Login list** se sab ke login ki list (Excel) nikal kar WhatsApp par bhej dein. Kisi ka login badalna ho to donor khol kar **Reset username & password** dabayein.
   - Donor pehli dafa login kare to usay apna password badalne ko kaha jata hai.
9. **Donors ko link bhejein** (WhatsApp par):
   > Assalam-o-Alaikum! Apni monthly donation ki receipt yahan jama karein: https://…/donor
   > Username: aap ka mobile number (03…), password: bua- aur aap ke orphan ka code (jaise bua-or001). Login ke baad apna password badal lein.
   > Phone ke browser menu se "Add to Home screen" karne se app ban jayegi.

### Apna domain (optional)
`donate.baitulaqba.org` jaisa address chahiye to Render mein **Settings → Custom Domains** mein domain dalein, aur jo DNS record Render bataye woh apne domain provider par laga dein. HTTPS khud lag jata hai.

### Updates
Jab bhi `main` branch mein naya code aayega, Render khud dobara deploy kar dega. Data (disk) mehfooz rehta hai.

---

## Tareeqa 2: Apna VPS server (sasta, lekin thoda technical)

DigitalOcean, Hetzner ya kisi aur ka Ubuntu server ($4–6 mahana) ho to:

```bash
# server par (Ubuntu), aik dafa
sudo apt update && sudo apt install -y docker.io caddy git
git clone https://github.com/asadahmed0604-pixel/baitul-aqba.git && cd baitul-aqba
sudo docker build -t baitul-aqba .
sudo mkdir -p /srv/baitul-aqba && sudo chown 1000:1000 /srv/baitul-aqba
sudo docker run -d --name baitul-aqba --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v /srv/baitul-aqba:/var/data \
  -e SECURE_COOKIES=1 -e TRUST_PROXY=1 \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='mazboot-password' \
  baitul-aqba
```

Domain ka A-record server ke IP par lagayein. Phir `/etc/caddy/Caddyfile` mein yeh likhein (HTTPS khud lag jayega):

```
donate.baitulaqba.org {
    reverse_proxy 127.0.0.1:3000
}
```

Phir `sudo systemctl reload caddy` chalayein.

---

## Hifazat aur backup

- **Backup:** saara data (database + receipt images) aik folder mein hai: Render par disk `/var/data`, VPS par `/srv/baitul-aqba`.
  - Render disks ke khud-kaar snapshots banata hai; dashboard mein **Disk** tab dekh lein.
  - Is ke ilawa mahine mein aik dafa **Import / Export → Donation entries** ki CSV apne computer par save kar lein.
- **Passwords:** management password kisi ko na dein. Team ke har member ke liye **Settings → Management users** mein alag account banayein.
- **Self-registration:** agar sirf aap donors ke accounts banana chahte hain, to **Settings** mein "Donors can register themselves" band kar dein, aur donors ko **Donors → Add donor** se account aur password dein.
- **Receipt ka text parhna:** donor ke phone par hota hai (Tesseract.js, internet se load hota hai). Parh na sake to donor khud details likhta hai, aur entry par "manual check" ka nishan lag jata hai.
