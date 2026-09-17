'use strict';
/**
 * Seed data for a fresh installation.
 *
 * Prices are stored in minor units (cents) so all money maths stays in integers.
 * Everything here can be edited later from the Admin screen (/admin.html).
 */

const SETTINGS = {
  hotelName: 'Azure Bay Hotel',
  restaurantName: 'The Terrace Restaurant',
  address: '12 Marine Drive, Seafront District',
  phone: '+1 (555) 018-2200',
  email: 'terrace@azurebay.example',
  taxLabel: 'VAT',
  taxPct: 8,
  servicePct: 10,
  serviceLabel: 'Service charge',
  currency: { code: 'USD', symbol: '$', decimals: 2, position: 'before' },
  // Public origin used when building table QR links. Empty = derive from the request host.
  baseUrl: '',
  requireCashierApproval: true,
  autoPrintOnPayment: false,
  demoMode: true,
  payMethods: [
    { id: 'cash', label: 'Cash', detail: 'Cash at the counter or table', enabled: true, needsReference: false },
    { id: 'card', label: 'Card', detail: 'Visa / Mastercard terminal', enabled: true, needsReference: false },
    { id: 'mobile', label: 'Mobile Money', detail: 'MoMo / M-Pesa wallet transfer', enabled: true, needsReference: true },
    { id: 'room', label: 'Charge to Room', detail: 'Post the bill to the guest folio', enabled: true, needsReference: true }
  ]
};

const STAFF = [
  { id: 'ST-01', name: 'Amina K.', role: 'manager', pin: '9999', active: true },
  { id: 'ST-02', name: 'Daniel O.', role: 'cashier', pin: '1111', active: true },
  { id: 'ST-03', name: 'Marco S.', role: 'chef', pin: '2222', active: true },
  { id: 'ST-04', name: 'Yasmine A.', role: 'waiter', pin: '3333', active: true },
  { id: 'ST-05', name: 'Peter N.', role: 'waiter', pin: '3334', active: true }
];

const TABLES = [
  ['T01', 'Table 1', 2, 'Terrace'],
  ['T02', 'Table 2', 2, 'Terrace'],
  ['T03', 'Table 3', 4, 'Terrace'],
  ['T04', 'Table 4', 4, 'Garden'],
  ['T05', 'Table 5', 4, 'Garden'],
  ['T06', 'Table 6', 6, 'Garden'],
  ['T07', 'Table 7', 2, 'Poolside'],
  ['T08', 'Table 8', 4, 'Poolside'],
  ['T09', 'Table 9', 6, 'Indoor'],
  ['T10', 'Table 10', 8, 'Indoor'],
  ['T11', 'Bar seat 1', 1, 'Bar'],
  ['T12', 'Bar seat 2', 1, 'Bar'],
  ['R01', 'Room service 101', 1, 'Rooms'],
  ['R02', 'Room service 204', 1, 'Rooms']
].map(([id, label, seats, zone]) => ({ id, label, seats, zone, active: true }));

const CATEGORIES = [
  { id: 'cat-starters', name: 'Starters & Small Plates', sort: 1, icon: '🥗' },
  { id: 'cat-soups', name: 'Soups & Salads', sort: 2, icon: '🥣' },
  { id: 'cat-grill', name: 'From the Grill', sort: 3, icon: '🔥' },
  { id: 'cat-mains', name: 'Main Courses', sort: 4, icon: '🍛' },
  { id: 'cat-pasta', name: 'Pizza & Pasta', sort: 5, icon: '🍝' },
  { id: 'cat-sides', name: 'Sides', sort: 6, icon: '🍟' },
  { id: 'cat-desserts', name: 'Desserts', sort: 7, icon: '🍰' },
  { id: 'cat-hot', name: 'Hot Drinks', sort: 8, icon: '☕' },
  { id: 'cat-cold', name: 'Cold Drinks', sort: 9, icon: '🥤' }
];

/* item: [name, price(cents), categoryId, prepMinutes, description, tags] */
const ITEMS = [
  ['Garlic Butter Prawns', 1250, 'cat-starters', 12, 'Tiger prawns, garlic butter, chilli, toasted baguette', ['chefs-pick']],
  ['Crispy Calamari', 1050, 'cat-starters', 10, 'Lightly battered squid rings, lemon aioli', []],
  ['Chicken Satay Skewers', 950, 'cat-starters', 12, 'Grilled chicken, peanut sauce, cucumber relish', []],
  ['Vegetable Spring Rolls', 750, 'cat-starters', 9, 'Crisp rolls, sweet chilli dip', ['veg']],
  ['Beef Samosa (3 pcs)', 700, 'cat-starters', 8, 'Spiced beef, house pastry, tamarind chutney', []],
  ['Soup of the Day', 650, 'cat-soups', 7, 'Ask your waiter — served with warm bread', []],
  ['Cream of Mushroom Soup', 700, 'cat-soups', 8, 'Button mushrooms, thyme cream, croutons', ['veg']],
  ['Caesar Salad', 900, 'cat-soups', 7, 'Cos lettuce, parmesan, croutons, anchovy dressing', []],
  ['Grilled Chicken Salad', 1100, 'cat-soups', 10, 'Chargrilled chicken, avocado, cherry tomato, citrus dressing', []],
  ['Ribeye Steak 300g', 2450, 'cat-grill', 22, 'Dry-aged ribeye, rosemary butter, choice of sauce', ['chefs-pick']],
  ['Sirloin Steak 250g', 2100, 'cat-grill', 20, 'Grilled to your liking, peppercorn or mushroom sauce', []],
  ['Lamb Chops', 2300, 'cat-grill', 22, 'Marinated lamb, mint yoghurt, grilled vegetables', []],
  ['BBQ Pork Ribs', 1900, 'cat-grill', 25, 'Slow-cooked ribs, smoky glaze, coleslaw', ['spicy']],
  ['Grilled Tilapia Fillet', 1750, 'cat-grill', 18, 'Whole fillet, lemon butter, herbs', []],
  ['Butter Chicken', 1500, 'cat-mains', 18, 'Creamy tomato gravy, basmati rice, naan', ['spicy']],
  ['Beef Stew in Clay Pot', 1650, 'cat-mains', 25, 'Slow braised beef, root vegetables, ugali or rice', ['chefs-pick']],
  ['Chicken Biryani', 1450, 'cat-mains', 20, 'Fragrant spiced rice, raita, pickled onion', ['spicy']],
  ['Vegetable Curry', 1200, 'cat-mains', 16, 'Seasonal vegetables, coconut curry, steamed rice', ['veg']],
  ['Fish & Chips', 1350, 'cat-mains', 15, 'Beer-battered cod, hand-cut chips, tartare sauce', []],
  ['Margherita Pizza', 1150, 'cat-pasta', 14, 'San Marzano tomato, mozzarella, basil', ['veg']],
  ['Pepperoni Pizza', 1350, 'cat-pasta', 14, 'Pepperoni, mozzarella, oregano', []],
  ['Spaghetti Bolognese', 1250, 'cat-pasta', 16, 'Slow-cooked beef ragù, parmesan', []],
  ['Penne Alfredo', 1150, 'cat-pasta', 14, 'Cream sauce, mushroom, parmesan', ['veg']],
  ['Hand-cut Chips', 450, 'cat-sides', 8, 'Sea salt, rosemary', ['veg']],
  ['Steamed Rice', 400, 'cat-sides', 5, 'Fragrant basmati', ['veg']],
  ['Grilled Vegetables', 550, 'cat-sides', 8, 'Courgette, pepper, aubergine, olive oil', ['veg']],
  ['Chocolate Fondant', 850, 'cat-desserts', 12, 'Warm chocolate cake, vanilla ice cream', ['chefs-pick']],
  ['Cheesecake Slice', 750, 'cat-desserts', 5, 'Baked vanilla cheesecake, berry compote', ['veg']],
  ['Seasonal Fruit Platter', 700, 'cat-desserts', 6, 'Fresh sliced fruit, mint, lime', ['veg']],
  ['Ice Cream (2 scoops)', 550, 'cat-desserts', 3, 'Choose vanilla, chocolate or strawberry', ['veg']],
  ['Espresso', 350, 'cat-hot', 4, 'Double shot, Italian roast', ['veg']],
  ['Cappuccino', 400, 'cat-hot', 5, 'Espresso, steamed milk, cocoa dust', ['veg']],
  ['African Tea Pot', 450, 'cat-hot', 6, 'Spiced milk tea, serves one', ['veg']],
  ['Fresh Passion Juice', 500, 'cat-cold', 4, 'Freshly squeezed, no added sugar', ['veg']],
  ['Mango Smoothie', 600, 'cat-cold', 6, 'Mango, yoghurt, honey', ['veg']],
  ['Soft Drink 330ml', 300, 'cat-cold', 2, 'Coke, Fanta, Sprite or soda water', ['veg']],
  ['Still / Sparkling Water 500ml', 250, 'cat-cold', 2, 'Chilled bottle', ['veg']],
  ['Local Beer 500ml', 550, 'cat-cold', 2, 'Ask for today\'s selection', []],
  ['House Wine (glass)', 700, 'cat-cold', 2, 'Red, white or rosé', []]
];

function menuItems() {
  return ITEMS.map(([name, price, categoryId, prepMinutes, description, tags], i) => ({
    id: 'M' + String(i + 1).padStart(3, '0'),
    name,
    price,
    categoryId,
    prepMinutes,
    description,
    tags,
    available: true
  }));
}

module.exports = { SETTINGS, STAFF, TABLES, CATEGORIES, ITEMS, menuItems };
