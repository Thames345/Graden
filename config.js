/* ===================================================================
   ตั้งค่าการเชื่อมต่อ Supabase — แก้ไฟล์นี้ไฟล์เดียว

   ⚠️ เวลาอัปเดตแอปเป็นเวอร์ชันใหม่ ให้แทนที่แค่
      index.html / style.css / app.js
      *** ห้ามแทนที่ไฟล์ config.js นี้ *** ไม่งั้นค่าที่ใส่ไว้จะหายและ
      แอปจะกลับไปเป็นโหมดออฟไลน์ (ไม่ขึ้นหน้าเข้าสู่ระบบ)

   หาค่าได้ที่ Supabase → Project Settings → API
   (anon public key ใส่ตรงนี้ได้ปลอดภัย เพราะ RLS เป็นตัวกันข้อมูล
    ห้ามใส่ service_role key เด็ดขาด)
   =================================================================== */

window.SAG_CONFIG = {
  SUPABASE_URL:      'https://xkprpjnsxeaiwpyenjxs.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhrcHJwam5zeGVhaXdweWVuanhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3ODAzNzQsImV4cCI6MjEwMjM1NjM3NH0.2T3daWv_6SpC4tiJVxmCIErm7YHpT5Dk_GsH0fZbs6k'
};
