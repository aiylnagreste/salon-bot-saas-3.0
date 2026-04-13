require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getDb, ensureTenantTables, invalidateSettingsCache, getCurrentTenant } = require('./database');

module.exports = function (tenantId) {
  // If tenantId is provided, use it; otherwise try to get from context
  const tid = tenantId || getCurrentTenant();

  if (!tid) {
    console.error('❌ No tenant ID provided or set in context. Cannot seed.');
    return;
  }

  console.log(`🌱 Seeding database for tenant: ${tid}`);

  // Ensure all tables exist for this tenant
  ensureTenantTables(tid);

  const db = getDb();

  // Define tenant-prefixed table names
  const tables = {
    deals: `${tid}_deals`,
    services: `${tid}_services`,
  };

  // Clear existing data for this tenant (only tenant-specific tables)
  try {
    db.exec(`DELETE FROM ${tables.deals};`);
    db.exec(`DELETE FROM ${tables.services};`);
    console.log(`✅ Cleared existing data for tenant ${tid}`);
  } catch (error) {
    console.log(`ℹ️  Some tables might not exist yet for ${tid}, continuing...`);
  }


  
  // Seed deals (base table - shared)
  const insertDeal = db.prepare(
    `INSERT INTO ${tables.deals} (title, description, active) VALUES (?, ?, ?)`
  );

  const deals = [
    ['Weekend Special', 'Get 20% off all hair services every Saturday and Sunday!', 1],
    ['Student Discount', 'Show your student ID and enjoy 15% off any service.', 1],
    ['Loyalty Package', 'Book 5 sessions and get the 6th one FREE!', 1],
    ['New Client Offer', 'First visit? Enjoy a complimentary hair treatment with any service.', 0],
  ];

  for (const [title, description, active] of deals) {
    insertDeal.run(title, description, active);
  }
  console.log(`✅ Seeded ${deals.length} deals`);

  // Seed services (base table - shared)
  const insertService = db.prepare(
    `INSERT INTO ${tables.services} (name, price, description, branch, durationMinutes) VALUES (?, ?, ?, ?, ?)`
  );

  const services = [
    // ── Hydrafacial ──────────────────────────────────────────────────────────
    {
      name: 'Hydrafacial – Deal 1',
      price: '3,199',
      desc: 'Whitening Glow Polisher · Hydra Machine (8 Tools) · Face Massage · Shoulder Massage · Vitamin C Mask with LED · Whitening Manicure · Whitening Pedicure · Hands & Feet Massage · Hands & Feet Polisher · Nail Cuticles · Eyebrows & Upper Lips',
      branch: 'All Branches',
      duration: 120,
    },
    {
      name: 'Full Body Waxing – Deal 2',
      price: '2,499',
      desc: 'Full Body Waxing · Bikini & Underarms Waxing · Half Arms Polisher · Feet Polisher',
      branch: 'All Branches',
      duration: 90,
    },
    {
      name: '24K Gold Facial – Deal 1',
      price: '2,199',
      desc: 'Whitening Glow Skin Polisher · Gold 4 Creams Massage · Neck & Shoulder Relaxing Massage · Whitening Manicure · Whitening Pedicure · Hands & Feet Polisher · Nail Cuticles · Hands & Feet Massage · Hair Protein Application · Eyebrows & Upper Lips',
      branch: 'All Branches',
      duration: 120,
    },
    {
      name: 'Janssen Facial Deal',
      price: '3,999',
      desc: 'Janssen 4 Creams Massage · Whitening Skin Glow Polisher · Blackheads Removal · Shoulder Massage · Janssen Peel-Off Mask · Eyebrows & Upper Lips · Skin Truth Manicure · Skin Truth Pedicure · Hands & Feet Massage · Hands & Feet Polisher · Nail Cuticles · Feet Mask',
      branch: 'All Branches',
      duration: 150,
    },
    {
      name: 'Fruit Facial – Deal 1',
      price: '999',
      desc: "Fruit Facial · Double Whitening Skin Glow Polisher · 4 Fruit Creams Massage · Shoulder Relaxing Massage · Fruit Face Mask · Blackhead Removal · Hand & Feet Whitening Polisher · Eyebrows & Upper Lips · L'Oréal Hair Protein Treatment Application",
      branch: 'All Branches',
      duration: 90,
    },
    {
      name: 'Derma Clear Facial – Deal 1',
      price: '2,199',
      desc: "Derma Clear Facial · Whitening Skin Polisher · Derma Clear 4 Creams Massage · Face Mask · L'Oréal Hair Protein Treatment · Eyebrows & Upper Lips · Manicure · Pedicure · Hand & Feet Polisher · Nail Cuticles · Shoulders Relaxing Massage",
      branch: 'All Branches',
      duration: 120,
    },
    {
      name: 'Whitening Manicure & Pedicure – Deal 1',
      price: '999',
      desc: 'Whitening Manicure · Whitening Pedicure · Whitening Hands & Feet Polisher · Hands & Feet Massage · Nail Cuticles',
      branch: 'All Branches',
      duration: 60,
    },
    {
      name: 'Gold Manicure & Pedicure – Deal 2',
      price: '1,999',
      desc: 'Gold 3 Creams Massage · Whitening Hands & Feet Polisher · Gold 3 Creams Hand Massage · Gold 3 Creams Feet Massage · Gold Hand & Feet Mask · Nail Cuticles',
      branch: 'All Branches',
      duration: 75,
    },
    {
      name: 'Acrylic Nails – Deal 1',
      price: '2,999',
      desc: 'Hand Massage · Hand Scrub · Hand Polisher · Simple Nail Paint',
      branch: 'All Branches',
      duration: 90,
    },
    {
      name: 'Acrylic French Nails – Deal 2',
      price: '3,499',
      desc: 'Hand Polisher · Hand Massage · Hand Scrub',
      branch: 'All Branches',
      duration: 100,
    },
    {
      name: 'Eyelash Extensions – Classic',
      price: '2,499',
      desc: 'Classic Lash Set · Face 2 Cream Gold Massage · Gold Face Mask (Free)',
      branch: 'All Branches',
      duration: 120,
    },
    {
      name: 'Eyelash Extensions – Hybrid',
      price: '2,999',
      desc: 'Hybrid Lash Set · Face 2 Cream Gold Massage · Gold Face Mask (Free)',
      branch: 'All Branches',
      duration: 150,
    },
    {
      name: 'Eyelash Extensions – Volume',
      price: '3,499',
      desc: 'Volume Lash Set · Face 2 Cream Gold Massage · Gold Face Mask (Free)',
      branch: 'All Branches',
      duration: 180,
    },
    {
      name: 'Hair Cutting – Deal 1',
      price: '1,999',
      desc: 'Hair Cutting · Hair Shampoo Wash · Hair Protein Treatment · Hair Relaxing Massage · Hair High Frequency · Hair Setting',
      branch: 'All Branches',
      duration: 90,
    },
    {
      name: 'Hair Cutting – Deal 2',
      price: '999',
      desc: 'Hair Wash · Hair Cutting · Hair Dry Only',
      branch: 'All Branches',
      duration: 45,
    },
    {
      name: "Keratin / L'Oréal Xtenso / Rebonding",
      price: 'From 5,999',
      desc: 'Free: Hair Cutting · Hair Glossing · 1x Hair Wash & Mask | Shoulder Rs.5,999 · Elbow Rs.7,999 · Waist Rs.9,999 · Hip Rs.11,999',
      branch: 'All Branches',
      duration: 240,
    },
    {
      name: 'Highlights / Lowlights / Balayage',
      price: 'From 5,999',
      desc: 'Free: Hair Cutting · Hair Wash · Hair Glossing · Hair Setting · Hair Protein Mask Wash | Shoulder Rs.5,999 · Elbow Rs.6,999 · Waist Rs.8,999 · Hip Rs.10,999',
      branch: 'All Branches',
      duration: 180,
    },
    {
      name: 'Party Makeup Deal',
      price: '2,999',
      desc: 'Party Makeup · Hair Styling · 6D Eyelashes · Nail Paint',
      branch: 'All Branches',
      duration: 120,
    },
    {
      name: 'Bridal Makeup Deal',
      price: '19,900',
      desc: 'Bridal First Day OR Walima Makeup · Bridal 6D Eyelashes · Bridal Hair Styling · Dupatta Settings · Nail Paint · 2 Party Makeups Free (with Eyelashes & Hair Styling)',
      branch: 'All Branches',
      duration: 240,
    },
    {
      name: 'Nikkah Makeup Deal (with Janssen Whitening Facial)',
      price: '18,000',
      desc: 'Nikkah Makeup · Janssen Whitening Facial · Whitening Manicure · Whitening Pedicure · Threading · Hair Botox Treatment',
      branch: 'All Branches',
      duration: 180,
    },
    {
      name: 'Bridal Makeup Package 1',
      price: '34,995',
      desc: 'Signature Bridal Makeup · 2 Facials (Janssen + Hydra) · 2x Mani & Pedi (Skin Truth + Whitening) · Full Body Waxing · Full Body Scrubbing · Full Body Polisher · Eyebrows & Upper Lips · Hair Cutting · Hair Protein Treatment',
      branch: 'All Branches',
      duration: 360,
    },
    {
      name: 'Bridal Makeup Package 2',
      price: '24,995',
      desc: 'Bridal Makeup · 2 Facials (Whitening + Gold) · 2x Mani & Pedi (Skin Truth + Whitening) · Full Body Wax · Full Body Polisher · Eyebrows & Upper Lips · Hair Protein Treatment',
      branch: 'All Branches',
      duration: 300,
    },
  ];

  for (const s of services) {
    if (!s.duration) {
      console.error(`❌ ERROR: Service "${s.name}" missing required duration (in minutes)`);
      throw new Error(`Service "${s.name}" must have a duration field`);
    }
    insertService.run(s.name, s.price, s.desc, s.branch, s.duration);
  }
  console.log(`✅ Seeded ${services.length} services`);

 
  console.log(`✅ Seeding completed successfully for tenant: ${tid}`);
  invalidateSettingsCache();
};