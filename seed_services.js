const admin = require('firebase-admin');
const fs = require('fs');

// Load service account from file (place your serviceAccountKey.json in the same folder)
const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://gograb-ke.firebaseio.com',
});

const firestore = admin.firestore();

const categories = {
  Healthcare: ['General Checkup', 'Dental', 'Physiotherapy', 'Lab Tests'],
  Catering: ['Buffet', 'Plated Service', 'Corporate Lunches', 'Cocktails'],
  Handyman: ['Furniture Assembly', 'Painting', 'Wall Drilling', 'General Repairs'],
  Electrician: ['Wiring', 'Installation', 'Repair', 'Maintenance'],
  Plumber: ['Leak Repair', 'Pipe Installation', 'Drain Cleaning', 'Water Heater'],
  Cleaning: ['House Cleaning', 'Office Cleaning', 'Deep Clean', 'Move‑out Clean'],
  'Pest Control': ['Termites', 'Rodents', 'Fumigation', 'Bed Bugs'],
  Laundry: ['Wash & Fold', 'Dry Cleaning', 'Ironing', 'Stain Removal'],
  Moving: ['Local Moving', 'Long‑distance', 'Office Relocation', 'Packing Only'],
  Tutoring: ['Maths', 'Sciences', 'Languages', 'Test Prep'],
  Mechanic: ['Engine Repair', 'Brakes', 'Electrical System', 'Diagnostics'],
};

// Sample vendor data
const vendors = [
  { uid: 'vendor_health', name: 'MediCare Services', phone: '254701234567', email: 'medi@care.com', categories: ['Healthcare'] },
  { uid: 'vendor_cater', name: 'Feast Masters', phone: '254702345678', email: 'feast@masters.com', categories: ['Catering'] },
  { uid: 'vendor_handy', name: 'FixIt Handyman', phone: '254703456789', email: 'fixit@handyman.com', categories: ['Handyman', 'Electrician', 'Plumber'] },
  { uid: 'vendor_clean', name: 'Sparkle Clean', phone: '254704567890', email: 'sparkle@clean.com', categories: ['Cleaning', 'Laundry'] },
  { uid: 'vendor_pest', name: 'BugBusters', phone: '254705678901', email: 'bug@busters.com', categories: ['Pest Control'] },
  { uid: 'vendor_move', name: 'MoveIt Logistics', phone: '254706789012', email: 'moveit@logistics.com', categories: ['Moving'] },
  { uid: 'vendor_tutor', name: 'BrainBoost Tutoring', phone: '254707890123', email: 'brain@boost.com', categories: ['Tutoring'] },
  { uid: 'vendor_mechanic', name: 'AutoPro Mechanic', phone: '254708901234', email: 'auto@pro.com', categories: ['Mechanic'] },
];

async function seed() {
  console.log('🌱 Seeding vendors...');
  for (const v of vendors) {
    await firestore.collection('users').doc(v.uid).set({
      name: v.name,
      phone: v.phone,
      email: v.email,
      role: 'vendor',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`✅ Vendor ${v.name}`);
  }

  console.log('🌱 Seeding service providers...');
  let count = 0;
  for (const [cat, subs] of Object.entries(categories)) {
    const vendor = vendors.find(v => v.categories.includes(cat)) || vendors[0];
    for (const sub of subs) {
      // Create 1-2 providers per subcategory
      const providers = [
        {
          vendorId: vendor.uid,
          name: `${vendor.name.split(' ')[0]} ${sub}`,
          phone: vendor.phone,
          category: cat,
          subcategories: [sub],
          pricingType: (cat === 'Cleaning' || cat === 'Tutoring') ? 'hourly' : 'per_job',
          hourlyRate: Math.floor(Math.random() * 500) + 300,
          perJobBase: Math.floor(Math.random() * 2000) + 500,
          instantFeeMultiplier: 1.5,
          allowsInstant: Math.random() > 0.3,
          isOnline: true,
          rating: (3.5 + Math.random() * 1.5).toFixed(1),
          jobsCompleted: Math.floor(Math.random() * 120),
          imageUrl: '',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {
          vendorId: vendors[1].uid,
          name: `Quick ${sub} (${vendors[1].name.split(' ')[0]})`,
          phone: vendors[1].phone,
          category: cat,
          subcategories: [sub],
          pricingType: 'per_job',
          perJobBase: Math.floor(Math.random() * 1500) + 400,
          instantFeeMultiplier: 1.5,
          allowsInstant: Math.random() > 0.5,
          isOnline: true,
          rating: (3.8 + Math.random() * 0.7).toFixed(1),
          jobsCompleted: Math.floor(Math.random() * 80),
          imageUrl: '',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      ];
      for (const p of providers) {
        await firestore.collection('service_providers').add(p);
        count++;
      }
    }
  }
  console.log(`✅ Seeded ${count} service providers.`);
}

seed().catch(console.error).finally(() => process.exit());