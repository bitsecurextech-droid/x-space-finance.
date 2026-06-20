const db = require('../config/database');

async function addMissingColumns() {
  console.log('Adding missing columns to users table...');
  
  const columnsToAdd = [
    'phone TEXT',
    'country TEXT DEFAULT "United Kingdom"',
    'dob TEXT',
    'address TEXT',
    'city TEXT',
    'state TEXT',
    'postal_code TEXT',
    'kyc_document_type TEXT',
    'kyc_full_name TEXT',
    'kyc_document_number TEXT',
    'kyc_document_path TEXT',
    'kyc_submitted_at DATETIME'
  ];
  
  for (const column of columnsToAdd) {
    try {
      await db.run(`ALTER TABLE users ADD COLUMN ${column}`);
      console.log(`✅ Added column: ${column.split(' ')[0]}`);
    } catch (err) {
      if (err.message.includes('duplicate column name')) {
        console.log(`⚠️ Column already exists: ${column.split(' ')[0]}`);
      } else {
        console.log(`❌ Error: ${err.message}`);
      }
    }
  }
  
  console.log('✅ Migration complete!');
}

addMissingColumns().catch(console.error);
